import { describe, it, expect } from 'vitest'
import { Volume } from 'memfs'
import { runUpdateGate } from './update-gate.js'
import { classifyInstall } from './install-target.js'
import { NPM_VERSION_QUERY } from './update-check.js'
import { versionCachePath } from './version-cache.js'

// #200 QA augmentation — the gate's classification seam, attacked where the dev's two
// files stop.
//
// lib/update-gate.notice-command.test.js proves the per-layout notice, the per-layout
// channel and the spawn counts on well-formed classifications;
// lib/update-gate.channel.qa.test.js proves the cross-consumer transcripts and ten
// hostile `classify` shapes. Neither of them asks the four questions below, and each
// one is load-bearing for a claim #200 makes in prose:
//
//   1. THE `exec: null` SHORTCUT, and the equivalence it rests on. The gate withholds
//      the spawner, so `classifyInstall` cannot run `npm root -g` — which means the one
//      layout it can never NAME is a plain npm global install: it comes back `unknown`.
//      The claim that this costs nothing is an equivalence between two different
//      classifications, and it is asserted here by running BOTH and comparing, rather
//      than by two tests that happen to expect the same literal. The other half of the
//      same shortcut is the layouts that fall into `unknown` and are NOT npm — this file
//      pins two of them, because "the command comes from your layout" is a stronger
//      promise than the marker table can keep.
//   2. THE MEMO. `installTarget()` is one call per run behind a memoized promise, feeding two
//      consumers (the channel thunk, then the notice). Pinned here: a FAILED
//      classification is cached rather than retried, a classification that answers
//      differently the second time cannot change the notice mid-run, and the memo is
//      per-CALL — two `runUpdateGate` calls in one process (which is what `ralph cycle`
//      is) classify independently, so no answer leaks between them.
//   3. THE NOTICE STRING at its blank edges. A label that is whitespace, a label that is
//      padded, a label that is truthy but not a string: the notice must never read
//      "(run  to update)", and it must never read "(run undefined to update)".
//   4. THE COST, as a tripwire rather than as a count. Every path documented to spend
//      nothing is driven with a POISON classification — one whose label and whose channel
//      would both be visible in the assertions if it were ever consulted — so a call
//      that happened and was ignored still fails.
//
// Not re-tested here: the per-layout notice table and the per-layout channel (the dev's
// two files above), the descriptor and label each layout carries
// (lib/install-target.notice.test.js), the `latestSource` seam itself
// (lib/update-check.decision-channel.test.js and its .qa), and the gate's own
// pre-#200 contract — verdict shape, TTY gate, stamp ordering, the unguarded `ask` and
// `stdout.write` (lib/update-gate.test.js, lib/update-gate.qa.test.js).
//
// Hermeticity (#41): `exec` is injected everywhere, the cache is memfs under a fake
// `home`, `isTTY` is explicit (it is undefined on a vitest worker, so a defaulted gate
// never prompts), and every run but one injects its layout as a path plus a memfs
// volume. The exception is the DEFAULT-SEAM test, which deliberately lets `classify`
// default and therefore reads the real RALPH_HOME — it asserts an agreement between the
// gate and `classifyInstall` on whatever that machine is, never a particular layout.

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
const strip = (s) => String(s).replace(ANSI, '')

const HOME = '/home/me'
const CACHE_PATH = versionCachePath({ processEnv: {}, home: HOME })
const CURRENT = '0.15.6'
const LATEST = '0.16.0'

const NPM_VIEW = 'npm view @lucasfe/ralph version'
const NPM_ROOT = 'npm root -g'
const BREW_INFO = 'brew info --json=v2 ralph'

const NPM_GLOBAL_ROOT = '/usr/local/lib/node_modules'
const NPM_RALPH = `${NPM_GLOBAL_ROOT}/@lucasfe/ralph`
const BREW_RALPH = '/opt/homebrew/Cellar/ralph/0.16.0/libexec/lib/node_modules/@lucasfe/ralph'

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    raw: () => chunks.join(''),
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

// The REAL classification for a given install path, driven exactly as production drives
// it: the gate's own bag is spread FIRST, so whatever the gate withholds — `exec` —
// stays withheld here too. The same idiom as lib/update-gate.channel.qa.test.js, for
// the same reason: a layout injected as a hand-written object would pass whatever the
// classifier stopped answering.
const layoutAt =
  (ralphHome, vol = Volume.fromJSON({})) =>
  (opts) =>
    classifyInstall({ ...opts, ralphHome, fs: vol })

// Any `classify`, plus the record of how it was called. Counts are how "once per run"
// and "never" are asserted; the bags are how "with no exec" is.
function recording(classify) {
  const spy = async (bag) => {
    spy.calls.push(bag)
    return classify(bag)
  }
  spy.calls = []
  return spy
}

// A classification that must never be consulted. Both of its answers are visible in
// the transcript — the label in the notice, the channel in the spawn list — so a call
// that happened and was ignored fails as loudly as one that was acted on. A THROW would
// not do: the gate guards this seam, so a throwing tripwire is a tripwire the code under
// test is allowed to swallow.
const POISON_LABEL = 'poison-command --update'
const POISON_QUERY = { argv: ['poison-query', 'latest'], format: 'semver-line' }
const poison = () =>
  recording(async () => ({
    kind: 'poison',
    argv: ['poison-command', '--update'],
    label: POISON_LABEL,
    noticeLabel: POISON_LABEL,
    reason: 'a classification no path here may ask for',
    advice: null,
    latest: POISON_QUERY,
  }))

const untouched = (g) => {
  expect(g.classify.calls).toHaveLength(0)
  expect(g.stdout.output()).not.toContain(POISON_LABEL)
  expect(g.exec.keys()).not.toContain('poison-query latest')
}

// The real decision, stamp and version query; the terminal, clock, cache, `exec` and
// layout injected. `ask` declines, so nothing reaches `runUpdate` unless a test says so.
function gate({ handlers = { [NPM_VIEW]: semver(LATEST) }, classify, ...overrides } = {}) {
  const stdout = makeStream()
  const stderr = makeStream()
  return {
    currentVersion: CURRENT,
    stdout,
    stderr,
    stdin: { marker: 'injected-stdin', isTTY: false },
    isTTY: false,
    exec: makeExec(handlers),
    classify: classify ?? recording(layoutAt(NPM_RALPH)),
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

// A cache inside both weekly windows, so the run is throttled and the prompt is not due.
const throttledCache = (latest = LATEST) =>
  Volume.fromJSON(
    {
      [CACHE_PATH]: JSON.stringify({
        last_check_at: '2026-09-01T12:00:00.000Z',
        latest_version: latest,
        last_prompted_at: '2026-09-01T12:00:00.000Z',
      }),
    },
    '/',
  )

describe('runUpdateGate — the equivalence `exec: null` rests on (#200 QA)', () => {
  it('answers a global npm install identically whether or not the probe could run', async () => {
    // The shortcut's whole defence: withholding the spawner costs the gate the KIND of a
    // plain npm global install (`unknown`, not `global-npm`) and nothing a notice or a
    // channel can see. Asserted as an agreement between two runs of the same install
    // path — one with the probe answerable, one as production drives it — so neither side
    // is a literal somebody could update to match the other.
    const probed = gate({
      classify: recording((opts) =>
        classifyInstall({
          ...opts,
          ralphHome: NPM_RALPH,
          fs: Volume.fromJSON({}),
          // The one difference: an answerable `npm root -g`. It is the layout's own
          // spawner, not the run's, so the gate's `exec` still records zero probes.
          exec: async () => ({ exitCode: 0, stdout: `${NPM_GLOBAL_ROOT}\n`, stderr: '' }),
        }),
      ),
    })
    const pathOnly = gate()
    await runUpdateGate(probed)
    await runUpdateGate(pathOnly)

    expect(probed.classify.calls).toHaveLength(1)
    expect(noticeOf(pathOnly)).toBe(noticeOf(probed))
    expect(noticeOf(pathOnly)).toBe(
      `New version available: ${LATEST} (run npm i -g @lucasfe/ralph to update)`,
    )
    expect(pathOnly.exec.keys()).toEqual(probed.exec.keys())
    expect(pathOnly.exec.keys()).toEqual([NPM_VIEW])
    // And the kinds really did differ, so the agreement above is about two different
    // classifications rather than one classification reached twice.
    const bag = { ralphHome: NPM_RALPH, fs: Volume.fromJSON({}) }
    expect((await classifyInstall({ ...bag, exec: null })).kind).toBe('unknown')
    expect(
      (
        await classifyInstall({
          ...bag,
          exec: async () => ({ exitCode: 0, stdout: `${NPM_GLOBAL_ROOT}\n`, stderr: '' }),
        })
      ).kind,
    ).toBe('global-npm')
  })

  it('asks the npm registry by IDENTITY on the layout it cannot name', async () => {
    // `unknown` carries NPM_VERSION_QUERY itself, not a copy of its argv — which is what
    // makes "the channel a plain npm install would have named" and "the channel an
    // unrecognized layout names" the same object rather than two equal ones.
    const seen = []
    const g = gate({
      update: async (bag) => {
        seen.push(await bag.latestSource())
        return { isNewer: false, latestVersion: null, shouldPrompt: false }
      },
    })
    await runUpdateGate(g)
    expect(seen).toEqual([NPM_VERSION_QUERY])
    expect(seen[0]).toBe(NPM_VERSION_QUERY)
  })

  it('never spawns the probe it withheld, even on the run that installs', async () => {
    const g = gate({
      isTTY: true,
      ask: async () => true,
      runUpdate: async () => ({ exitCode: 0, updated: true, to: LATEST }),
    })
    await runUpdateGate(g)
    expect(g.exec.keys()).not.toContain(NPM_ROOT)
    expect(g.classify.calls).toEqual([{ exec: null }])
  })

  it('DOCUMENTED: a non-npm layout the marker table misses is still told to run npm', async () => {
    // The limit of criterion 1, named because "the command comes from the classification"
    // reads as a promise the marker table cannot keep. pnpm's markers are the whole
    // segments `pnpm/global`; PNPM_HOME may point anywhere, and a store at `~/.pnpm` or
    // `/opt/pnpm-store` matches nothing — so the layout is `unknown`, and `unknown`
    // suggests npm. A pnpm user who pastes that gets exactly the harm #200 is about: a
    // SECOND copy on PATH, this one owned by npm.
    //
    // It is not a regression — every layout was told this before #200 — and it is bounded
    // by the table rather than unbounded: the default PNPM_HOME on macOS and Linux both
    // carry a literal `pnpm` segment (asserted below, so this test cannot quietly become
    // a claim about the common case). Widening the markers is its own change; what this
    // pins is that #200 did not close it.
    const g = gate({
      classify: recording(layoutAt('/Users/me/.pnpm/global/5/node_modules/@lucasfe/ralph')),
    })
    await runUpdateGate(g)
    expect(noticeOf(g)).toBe(
      `New version available: ${LATEST} (run npm i -g @lucasfe/ralph to update)`,
    )
    expect(g.exec.keys()).toEqual([NPM_VIEW])

    for (const store of [
      '/Users/me/Library/pnpm/global/5/node_modules/@lucasfe/ralph',
      '/Users/me/.local/share/pnpm/global/5/node_modules/@lucasfe/ralph',
    ]) {
      const recognized = await classifyInstall({
        ralphHome: store,
        exec: null,
        fs: Volume.fromJSON({}),
      })
      expect(recognized.kind).toBe('global-pnpm')
      expect(recognized.noticeLabel).toBe('pnpm add -g @lucasfe/ralph@latest')
    }
  })

  it('DOCUMENTED: an ambiguous multi-manager path is told npm as well', async () => {
    // `classifyInstall` fails CLOSED on the argv for a path two managers claim — no
    // command to run, `unknown` — but `unknown`'s notice command is npm's, so the notice
    // does not fail closed with it. The user reads one manager's command for a path that
    // matched two others.
    const g = gate({
      classify: recording(
        layoutAt('/Users/me/.config/yarn/global/node_modules/pnpm/global/node_modules/@lucasfe/ralph'),
      ),
    })
    await runUpdateGate(g)
    expect(noticeOf(g)).toBe(
      `New version available: ${LATEST} (run npm i -g @lucasfe/ralph to update)`,
    )
  })
})

describe('runUpdateGate — the default seam is the real classifier (#200 QA)', () => {
  it('classifies THIS install when no layout is injected, and still spawns no probe', async () => {
    // The seam's default is what every production call site relies on: `ralph start` and
    // `ralph cycle` forward `classify` with no default of their own, so an undefined value
    // lands on the gate's `classifyInstall`. Asserted as an AGREEMENT rather than as a
    // layout: whatever this machine is, the notice must say what `classifyInstall` says
    // about it when handed the same withheld exec. In a checkout that is `linked` (a
    // `.git`, no command at all); in an installed copy it is a command — both pass, and a
    // gate wired to some other classifier passes neither.
    const target = await classifyInstall({ exec: null })
    const expected = target.noticeLabel ? ` (run ${target.noticeLabel} to update)` : ''
    const g = gate({ classify: undefined })
    delete g.classify
    await runUpdateGate(g)
    expect(noticeOf(g)).toBe(`New version available: ${LATEST}${expected}`)
    expect(g.exec.keys()).toEqual([NPM_VIEW])
    expect(g.exec.keys()).not.toContain(NPM_ROOT)
  })
})

describe('runUpdateGate — the memo, at its three edges (#200 QA)', () => {
  it('caches a FAILED classification instead of retrying it for the second consumer', async () => {
    // Two consumers ask (the channel thunk, then the notice) and the classifier throws.
    // The memoized promise resolves to null, so the failure is the answer: one call, not two.
    // Retrying would double the filesystem probing of every run that prints a notice —
    // and, for a `classify` that DID spawn, double the spawns.
    const classify = recording(async () => {
      throw new Error('classify exploded')
    })
    const g = gate({ classify })
    await runUpdateGate(g)
    expect(classify.calls).toHaveLength(1)
    expect(noticeOf(g)).toBe(`New version available: ${LATEST}`)
    expect(g.exec.keys()).toEqual([NPM_VIEW])
  })

  it('caches a NULL classification too, rather than asking again for the notice', async () => {
    const classify = recording(async () => null)
    const g = gate({ classify })
    await runUpdateGate(g)
    expect(classify.calls).toHaveLength(1)
    expect(noticeOf(g)).toBe(`New version available: ${LATEST}`)
  })

  it('cannot change its mind between the channel and the notice', async () => {
    // One run, one layout. A classifier that answered brew first and npm second would
    // otherwise query the tap and then tell the user to run npm — the exact
    // one-run-two-answers split #200 exists to remove, reintroduced from the other side.
    let nth = 0
    const answers = [
      { noticeLabel: 'brew upgrade ralph', latest: { argv: ['brew', 'info', '--json=v2', 'ralph'], format: 'brew-json-v2' } },
      { noticeLabel: 'npm i -g @lucasfe/ralph', latest: NPM_VERSION_QUERY },
    ]
    const classify = recording(async () => answers[nth++] ?? answers[1])
    const g = gate({ classify, handlers: { [BREW_INFO]: brewInfo(LATEST), [NPM_VIEW]: semver('9.9.9') } })
    await runUpdateGate(g)
    expect(classify.calls).toHaveLength(1)
    expect(g.exec.keys()).toEqual([BREW_INFO])
    expect(noticeOf(g)).toBe(`New version available: ${LATEST} (run brew upgrade ralph to update)`)
    expect(g.stdout.output()).not.toContain('npm')
  })

  it('memoizes per CALL, so two gates in one process classify independently', async () => {
    // `ralph cycle` is one process that may run the gate more than once, and a
    // module-level cache would answer the second run with the first run's layout. Driven
    // with two different layouts through one classifier: each run gets its own.
    const layouts = [layoutAt(BREW_RALPH), layoutAt(NPM_RALPH)]
    let nth = 0
    const classify = recording((opts) => layouts[nth++](opts))
    const first = gate({ classify, handlers: { [BREW_INFO]: brewInfo(LATEST) } })
    const second = gate({ classify, handlers: { [NPM_VIEW]: semver(LATEST) } })
    await runUpdateGate(first)
    await runUpdateGate(second)
    expect(classify.calls).toHaveLength(2)
    expect(noticeOf(first)).toContain('brew upgrade ralph')
    expect(noticeOf(second)).toContain('npm i -g @lucasfe/ralph')
    expect(first.exec.keys()).toEqual([BREW_INFO])
    expect(second.exec.keys()).toEqual([NPM_VIEW])
  })

  it('does not let one run’s failed classification poison the next run', async () => {
    let nth = 0
    const classify = recording(async (opts) => {
      if (nth++ === 0) throw new Error('classify exploded')
      return layoutAt(BREW_RALPH)(opts)
    })
    const broken = gate({ classify })
    const working = gate({ classify, handlers: { [BREW_INFO]: brewInfo(LATEST) } })
    await runUpdateGate(broken)
    await runUpdateGate(working)
    expect(noticeOf(broken)).toBe(`New version available: ${LATEST}`)
    expect(noticeOf(working)).toBe(`New version available: ${LATEST} (run brew upgrade ralph to update)`)
  })

  it('answers every consumer the same classification, whichever order they ask in', async () => {
    // QA's DEFECT WITNESS, now the regression pin for the fix it asked for. The version it
    // was filed against memoized a BOOLEAN set before the await while `target` was assigned
    // after it, so a consumer that asked while the first classification was still in flight
    // was answered `undefined` — not the classification, and not "not yet classified". The
    // second `latestSource()` below resolved to no channel at all and the run fell back to
    // npm, the wrong channel for the layout it had just identified.
    //
    // The gate now memoizes the PROMISE, so every order of asking awaits the same
    // classification and gets the same answer.
    //
    // Unreachable from production either way: the two real consumers are strictly
    // sequential (resolveUpdateDecision awaits the thunk, the notice reads after it
    // returns), so it takes an injected `update` to ask twice at once. It is asserted
    // anyway because "at most once per run", for a value two consumers share, is a promise
    // about the ANSWER and not only about the call count.
    const classify = recording(async (opts) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return layoutAt(BREW_RALPH)(opts)
    })
    const seen = []
    const g = gate({
      classify,
      handlers: { [BREW_INFO]: brewInfo(LATEST) },
      update: async (bag) => {
        seen.push(...(await Promise.all([bag.latestSource(), bag.latestSource()])))
        return { isNewer: true, latestVersion: LATEST, shouldPrompt: false }
      },
    })
    await runUpdateGate(g)
    expect(classify.calls).toHaveLength(1)
    expect(seen[0]).toBeDefined()
    expect(seen[1]).toEqual(seen[0])
  })
})

describe('runUpdateGate — the notice at its blank edges (#200 QA)', () => {
  for (const [label, noticeLabel] of [
    ['an empty string', ''],
    ['spaces', '   '],
    ['a tab', String.fromCharCode(9)],
    ['a newline', String.fromCharCode(10)],
  ]) {
    it(`omits the whole clause for a label that is ${label}`, async () => {
      // Not "(run  to update)" with a hole in it: the clause is composed or it is absent.
      const g = gate({ classify: recording(async () => ({ noticeLabel, latest: null })) })
      await runUpdateGate(g)
      expect(g.stdout.lines()).toEqual([`New version available: ${LATEST}`])
      expect(g.stdout.output()).not.toContain('(run')
      expect(g.stdout.output()).not.toContain('to update')
    })
  }

  for (const [label, noticeLabel] of [
    ['a number', 42],
    ['a String object', Object('brew upgrade ralph')],
    ['an object with a toString', { toString: () => 'brew upgrade ralph' }],
    ['an array of words', ['brew', 'upgrade', 'ralph']],
    ['a function', () => 'brew upgrade ralph'],
    ['true', true],
  ]) {
    it(`offers no command when the label is ${label}`, async () => {
      // `typeof label === 'string'` is the test, so every one of these — including the
      // ones that would interpolate into something plausible — reads as no command
      // rather than as "run 42 to update" or "run brew,upgrade,ralph to update".
      const g = gate({ classify: recording(async () => ({ noticeLabel, latest: null })) })
      await runUpdateGate(g)
      expect(g.stdout.lines()).toEqual([`New version available: ${LATEST}`])
    })
  }

  it('trims a padded label rather than printing the padding', async () => {
    const g = gate({
      classify: recording(async () => ({ noticeLabel: '  brew upgrade ralph  ', latest: null })),
    })
    await runUpdateGate(g)
    expect(noticeOf(g)).toBe(`New version available: ${LATEST} (run brew upgrade ralph to update)`)
  })

  it('says nothing about npm in the RAW bytes of a Homebrew notice, colour included', async () => {
    // The dev's file asserts this on ANSI-stripped output. The user reads the bytes, so
    // the claim is re-made against them: nothing in picocolors' wrapping, and nothing in
    // the version, may reintroduce the word.
    const g = gate({
      classify: recording(layoutAt(BREW_RALPH)),
      handlers: { [BREW_INFO]: brewInfo(LATEST) },
    })
    await runUpdateGate(g)
    expect(g.stdout.raw()).toContain('brew upgrade ralph')
    expect(g.stdout.raw()).not.toMatch(/npm/i)
    expect(g.stderr.raw()).toBe('')
  })

  it('still lets a hostile latestVersion escape through the write (#200 widened no guard)', async () => {
    // The module header names exactly two unguarded boundaries — `ask` and the notice
    // write, interpolation included. #200 added a second interpolation to that same line,
    // so the pin is that the FIRST one still behaves as documented: a version whose
    // toString throws escapes, and it escapes AFTER the classification was read, which is
    // what proves the new work sits inside the guard and not out on the write.
    const boom = new Error('hostile version')
    const latestVersion = {
      toString() {
        throw boom
      },
    }
    const classify = recording(layoutAt(BREW_RALPH))
    const g = gate({
      classify,
      update: async () => ({ isNewer: true, latestVersion, shouldPrompt: false }),
    })
    await expect(runUpdateGate(g)).rejects.toBe(boom)
    expect(classify.calls).toHaveLength(1)
    expect(g.stdout.output()).toBe('')
  })
})

describe('runUpdateGate — what the cheap paths must not spend (#200 QA)', () => {
  it('never consults the layout on the RALPH_NO_UPDATE_CHECK opt-out', async () => {
    // The opt-out is documented to short-circuit before ANY cache read, network call or
    // output; #200 must not have added a filesystem probe behind it. The tripwire proves
    // the seam was not merely called-and-ignored.
    const g = gate({ classify: poison(), processEnv: { RALPH_NO_UPDATE_CHECK: '1' } })
    const verdict = await runUpdateGate(g)
    expect(verdict.isNewer).toBe(false)
    expect(g.exec.calls).toEqual([])
    untouched(g)
  })

  for (const [label, value] of [
    ['yes', 'yes'],
    ['true', 'true'],
    ['a padded 1', ' 1 '],
  ]) {
    it(`never consults it for the opt-out spelled ${label}`, async () => {
      const g = gate({ classify: poison(), processEnv: { RALPH_NO_UPDATE_CHECK: value } })
      await runUpdateGate(g)
      untouched(g)
    })
  }

  it('consults it on a throttled run only because there is a notice to print', async () => {
    // Inside the weekly window with something newer cached: no query, but the notice still
    // needs a command, so exactly one classification happens and no subprocess does.
    const classify = recording(layoutAt(BREW_RALPH))
    const g = gate({ classify, cacheFs: throttledCache() })
    await runUpdateGate(g)
    expect(g.exec.calls).toEqual([])
    expect(classify.calls).toEqual([{ exec: null }])
    expect(noticeOf(g)).toBe(`New version available: ${LATEST} (run brew upgrade ralph to update)`)
  })

  it('never consults it on a throttled run with nothing newer to say', async () => {
    const g = gate({ classify: poison(), currentVersion: LATEST, cacheFs: throttledCache() })
    await runUpdateGate(g)
    expect(g.stdout.output()).toBe('')
    expect(g.exec.calls).toEqual([])
    untouched(g)
  })

  it('classifies exactly once on a network run that finds nothing newer', async () => {
    // The other half of criterion 7's boundary: the query happens (the window was open),
    // so the channel had to be resolved — but `!isNewer` returns before the notice, so
    // the second consumer never asks and the count stays at one.
    const classify = recording(layoutAt(BREW_RALPH))
    const g = gate({ classify, handlers: { [BREW_INFO]: brewInfo(CURRENT) } })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({ isNewer: false, latestVersion: CURRENT })
    expect(classify.calls).toHaveLength(1)
    expect(g.exec.keys()).toEqual([BREW_INFO])
    expect(g.stdout.output()).toBe('')
  })

  it('leaves the weekly throttle and the prompt window measured in spawns, not in prose', async () => {
    // Criterion 6, as one comparison: the same gate, the same layout, inside and outside
    // the network window. One spawn becomes zero and the notice is unchanged.
    const open = gate({ classify: recording(layoutAt(BREW_RALPH)), handlers: { [BREW_INFO]: brewInfo(LATEST) } })
    const closed = gate({ classify: recording(layoutAt(BREW_RALPH)), cacheFs: throttledCache() })
    await runUpdateGate(open)
    await runUpdateGate(closed)
    expect(open.exec.calls).toHaveLength(1)
    expect(closed.exec.calls).toHaveLength(0)
    expect(noticeOf(closed)).toBe(noticeOf(open))
  })
})

describe('runUpdateGate — the classification the channel could not be read from (#200 QA)', () => {
  it('asks npm when the layout’s `latest` getter throws, and still names the layout', async () => {
    // The two reads are independent: the channel is read through a thunk inside
    // resolveUpdateDecision's guard, the command inside the gate's own. One of them
    // failing must not cost the other — the user still gets the right command, from the
    // wrong-channel-but-honest npm answer.
    const target = { noticeLabel: 'brew upgrade ralph' }
    Object.defineProperty(target, 'latest', {
      get() {
        throw new Error('hostile latest')
      },
    })
    const g = gate({
      classify: recording(async () => target),
      handlers: { [NPM_VIEW]: semver(LATEST), [BREW_INFO]: brewInfo('9.9.9') },
    })
    const verdict = await runUpdateGate(g)
    expect(verdict).toMatchObject({ isNewer: true, latestVersion: LATEST })
    expect(g.exec.keys()).toEqual([NPM_VIEW])
    expect(noticeOf(g)).toBe(`New version available: ${LATEST} (run brew upgrade ralph to update)`)
  })

  for (const [label, classify] of [
    ['not a function', 'classifyInstall'],
    ['a number', 7],
    ['null', null],
    ['an object', { classify: true }],
    ['a thenable whose then throws', () => ({ then() { throw new Error('bad then') } })],
    ['a function returning a rejected thenable', () => ({ then: (_, reject) => reject(new Error('nope')) })],
  ]) {
    it(`prints the version with no command when classify is ${label}`, async () => {
      // The seam is a value a caller passed, so it need not be callable at all. Calling a
      // non-function throws a TypeError from inside the guard, which is the same class of
      // failure as a classifier that throws — and the dev's file pins the classifier half.
      //
      // Assigned onto the bag rather than passed through `gate()`, whose own `??` default
      // would substitute a working layout for the falsy rows and quietly test nothing.
      const g = gate()
      g.classify = classify
      const verdict = await runUpdateGate(g)
      expect(verdict).toMatchObject({ isNewer: true, latestVersion: LATEST })
      expect(g.stdout.lines()).toEqual([`New version available: ${LATEST}`])
      expect(g.exec.keys()).toEqual([NPM_VIEW])
    })
  }

  it('ignores a classification’s own toString, which nothing interpolates', async () => {
    const target = {
      noticeLabel: 'brew upgrade ralph',
      latest: null,
      toString() {
        throw new Error('hostile toString')
      },
    }
    const g = gate({ classify: recording(async () => target) })
    await runUpdateGate(g)
    expect(noticeOf(g)).toBe(`New version available: ${LATEST} (run brew upgrade ralph to update)`)
  })
})

describe('runUpdateGate — the cache carries one channel to every reader (#200 QA)', () => {
  it('DOCUMENTED: a throttled run reads whichever channel last wrote, not its own', async () => {
    // The global version cache (~/.config/ralph/update-check.json) holds three fields and
    // none of them is the channel that answered. #200 made the writer channel-dependent
    // while leaving the reader channel-blind, so inside the weekly window every install on
    // the machine reads whatever the last one asked. Driven as the mixed-install case that
    // makes it visible: a Homebrew run caches the TAP's version, and an npm-layout run in
    // the same window prints that version beside `npm i -g` — a pairing the registry may
    // not have.
    //
    // Bounded, and stated so the size is not guessed at: at most one week, and only on a
    // machine with two installs (or one that switched managers). Before #200 the cache was
    // always npm's, so this is new with it. Pinned rather than filed: the fix is a field in
    // the cache, which is `ralph doctor`'s shape too.
    const brew = gate({
      classify: recording(layoutAt(BREW_RALPH)),
      handlers: { [BREW_INFO]: brewInfo(LATEST), [NPM_VIEW]: semver('9.9.9') },
    })
    await runUpdateGate(brew)
    expect(noticeOf(brew)).toContain('brew upgrade ralph')

    const npm = gate({
      classify: recording(layoutAt(NPM_RALPH)),
      cacheFs: brew.cacheFs,
      handlers: { [NPM_VIEW]: semver('9.9.9') },
      now: () => Date.parse('2026-09-04T12:00:00.000Z'),
    })
    await runUpdateGate(npm)
    expect(npm.exec.calls).toEqual([])
    expect(noticeOf(npm)).toBe(
      `New version available: ${LATEST} (run npm i -g @lucasfe/ralph to update)`,
    )
  })
})
