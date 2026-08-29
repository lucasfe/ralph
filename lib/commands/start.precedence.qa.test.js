// QA #122 — the `configured` closure in `ralph start`, attacked at the one seam it created.
//
// #122's first part replaced two copies of `parseConfigVar(configText, NAME) || processEnv[NAME]`
// with one closure declared inside the #69 precedence note, and pointed the model and the window
// at it. Nothing about that is a behaviour change on the happy path — which is exactly why it is
// worth a file of its own. What the closure DID do is give the loop's precedence a NAME, in a
// comment block that tells a reader "three knobs depart from this rule and each one's note says
// why". A named rule invites the question nobody had to ask while the expression was spelled out
// twice: is the rule the closure states the rule the loop actually follows?
//
// It is not, in one case, and that case is the whole of the first describe block below.
//
// THE MEASUREMENT THIS FILE IS BUILT ON. templates/ralph.sh sources ralph.config.sh with `set -a`,
// so what the loop's environment holds for a knob is decided by whether the FILE ASSIGNED it, not
// by whether the file's value was truthy. Run against a real bash, on this machine, with an
// inherited value in place:
//
//   $ printf 'RALPH_CODEX_MODEL=""\n' > c.sh
//   $ RALPH_CODEX_MODEL=gpt-5-codex bash -c 'set -a; . ./c.sh; set +a; printf "[%s]" "$RALPH_CODEX_MODEL"'
//   []
//
//   RALPH_CODEX_MODEL=""            -> []
//   RALPH_CODEX_MODEL=''            -> []
//   RALPH_CODEX_MODEL=              -> []
//   RALPH_CODEX_MODEL=<3 spaces>    -> []          (bash ends the word at the `=`)
//   RALPH_CODEX_MODEL="   "         -> [   ]       (quoted whitespace IS a value)
//   export RALPH_CODEX_MODEL=       -> []
//
// Five of those six BLANK the inherited value. `||` reaches past every one of them. That is the
// same defect #118 fixed for `RALPH_AGENT` and #120 fixed for `GH_REPO`, still live on the two
// knobs #122 gathered into a closure and on the `TASK_SOURCE` line beside them — and the tests in
// the first and last blocks below PIN THE CURRENT ANSWER rather than assert the right one, so that
// changing it is a deliberate act with a red test to argue with. Each one says, in its own
// comment, what its expectation must become on the day it is fixed. #149 carries the fix
// (`configAssignsVar` and `??`): they are recorded here as defects, not as design.
//
// The other three blocks are the closure's own edges, and they are all green as written:
//
//   * AN ENVIRONMENT WITH NO SUCH KEY. `processEnv[name]` on a bag that does not have the
//     property answers `undefined`, and `undefined` must arrive at `resolveBannerModel` as the
//     same "nobody configured this" the old dot access delivered — not as a row reading
//     `undefined`, which is the shape a stringly-typed fact leaks in.
//   * A PROTOTYPE-REACHABLE KEY. The closure indexes the bag with a computed name. A bag whose
//     OWN properties are empty but whose prototype carries the knob answers with the inherited
//     value — and so did `processEnv.RALPH_CODEX_MODEL`, which is the point that test makes.
//   * THE DEPARTING KNOBS STILL DEPART. `RALPH_BANNER` (inverted), `RALPH_AGENT` and `GH_REPO`
//     (present-or-absent) and `TASK_SOURCE` (its own reader) are four cheap regression pins that
//     make the closure's SCOPE observable from the outside, so a later "harmonize these" commit
//     goes red here instead of silently changing which agent, banner or repository a run gets.
//
// The harness is start.identity-facts.qa.test.js's, deliberately: every seam is injected (#41), so
// nothing here depends on the developer's checkout — not their .git, not their .ralph, not their
// environment. No control byte is typed (#107); the two this file needs are built from code
// points. And nothing here spells a bag-dot-NAME read in prose, because #41's ambient-surface scan
// is a regex over sources and this file, being a `.test.js`, is out of its scope only by the
// filename rule — the bracket form `processEnv[NAME]` is used in these comments anyway.

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { startCommand } from './start.js'
import { buildAgentInvocation } from '../agent-invocation.js'
import { resolveContextWindow } from '../issue-event.js'
import { EMPTY_VERSION_CACHE } from '../version-cache.js'

const REPO = '/repo'
const HOME = '/home/me'
const VERSION = '1.2.3'
const GIT_CONFIG_PATH = resolve(REPO, '.git', 'config')
const ORIGIN_SLUG = 'lucasfe/ralph'
const LF = String.fromCharCode(10)
const ESC = String.fromCharCode(27)
// The box's gutter, restated rather than imported — the rule every QA oracle in this repo follows
// (see the note above banner-rows.seam.qa.test.js's copy): a reader written from the module it
// audits is satisfied by any mistake the two of them agree on. #122 exported the constant for the
// CONTRACT specs, which measure labels against it; this file measures the OUTPUT.
const LABEL_WIDTH = 8

// The two knobs the closure reads, named once so a test reads as a claim about a knob rather
// than as a string comparison.
const MODEL = 'RALPH_CODEX_MODEL'
const WINDOW = 'RALPH_CONTEXT_WINDOW'

// A config file, always with a task source on the first line so the run has one — the source is
// the knob the LAST block is about, and leaving it implicit there would make two tests of one.
const cfg = (...lines) => [...lines, ''].join(LF)
const FOLDER = 'TASK_SOURCE=folder'
const GITHUB = 'TASK_SOURCE=github'
const CODEX = 'RALPH_AGENT=codex'

// One claude run in the log, which is all the log path needs to answer: the box's claude row
// comes from the newest event, so a single event is a complete fixture for it.
const eventLine = (fields) => `RALPH_ISSUE_EVENT ${JSON.stringify(fields)}`
const HISTORY =
  eventLine({
    issue_number: 30,
    run_id: 'ralph-b',
    ts: 2,
    duration_ms: 71 * 60000,
    total_cost_usd: 28.75,
    agent: 'claude',
    model: 'claude-opus-5',
    context_window: 1_000_000,
  }) + LF

// A .git/config the way git writes one, so the repo row has an origin to fall back to — which is
// the whole observable of the `GH_REPO` pin in the last block.
const GIT_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '[remote "origin"]',
  '\turl = git@github.com:lucasfe/ralph.git',
  '\tfetch = +refs/heads/*:refs/remotes/origin/*',
  '',
].join(LF)

const CSI_COLOUR = new RegExp(`${ESC}[[][0-9]+m`, 'g')
const stripAnsi = (text) => text.replaceAll(CSI_COLOUR, '')

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
    lines: () => {
      const text = chunks.join('')
      return text === '' ? [] : text.split(LF).slice(0, -1)
    },
  }
}

function makeExec({ queue = '9' } = {}) {
  const calls = []
  const exec = async (cmd, args = [], options = {}) => {
    calls.push({ key: `${cmd} ${args.join(' ')}`, cmd, args, options })
    if (cmd === 'tmux' && args[0] === 'has-session') return { exitCode: 1, stdout: '', stderr: '' }
    if (cmd === 'gh' && args[0] === 'issue' && args.includes('--search')) {
      return { exitCode: 0, stdout: queue, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  exec.calls = calls
  return exec
}

const deps = ({ config = cfg(FOLDER), metrics = '', gitConfig = GIT_CONFIG, queue = 3, ...overrides } = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  const paths = { exists: [], readFile: [] }
  return {
    cwd: REPO,
    stdout,
    stderr,
    paths,
    exec: makeExec(),
    exists: (p) => {
      paths.exists.push(String(p))
      return String(p).endsWith('ralph.config.sh') && config != null
    },
    readFile: (p) => {
      const path = String(p)
      paths.readFile.push(path)
      if (path.endsWith('ralph.config.sh')) return config
      if (path.endsWith('issues.jsonl')) return metrics
      if (path === GIT_CONFIG_PATH) return gitConfig
      return ''
    },
    loadEnv: () => ({}),
    hasCommand: () => true,
    ask: async () => true,
    currentVersion: VERSION,
    update: async () => ({
      latestVersion: null,
      isNewer: false,
      shouldPrompt: false,
      source: 'disabled',
      updatedCache: null,
    }),
    readCache: () => ({ ...EMPTY_VERSION_CACHE }),
    readChangelog: () => [],
    sendWa: async () => ({ ok: true }),
    peekLock: () => null,
    folderQueueCount: async () => queue,
    now: () => new Date(2026, 7, 25, 16, 4, 0).getTime(),
    home: HOME,
    processEnv: {},
    ...overrides,
  }
}

/** The box wherever it is, found by its own frame — nothing else here draws corners. */
const boxOf = (d) => {
  const lines = d.stdout.lines()
  const top = lines.findIndex((line) => line.startsWith('╭'))
  const bottom = lines.findIndex((line) => line.startsWith('╰'))
  return top === -1 || bottom < top ? [] : lines.slice(top, bottom + 1)
}

/** A row's value, frame and gutter removed — or undefined when the row is not drawn. */
const rowOf = (d, label) => {
  const row = boxOf(d).find((line) => stripAnsi(line).includes(`│ ${label}`))
  return row === undefined ? undefined : stripAnsi(row).slice(2, -2).trimEnd().slice(LABEL_WIDTH)
}

const run = async (options) => {
  const d = deps(options)
  const result = await startCommand(d)
  return { d, result }
}

/**
 * The codex command line the LOOP will build, given the environment `set -a` leaves it with.
 *
 * This is the oracle the first block measures the box against, and it is deliberately the real
 * `buildAgentInvocation` rather than a claim about it: the box's job is to name what the run will
 * use, and the run's model is whatever this argv carries. Its input is the environment the bash
 * transcript in this file's header MEASURED, spelled out per case rather than derived from the
 * parser under test, so nothing in this comparison shares a reader with `configured`.
 */
const loopModelFlag = (loopEnvValue) => {
  const { args } = buildAgentInvocation({ RALPH_AGENT: 'codex', [MODEL]: loopEnvValue })
  const at = args.indexOf('-m')
  return at === -1 ? null : args[at + 1]
}

describe('QA #122 — a config value that is PRESENT BUT EMPTY, and the `||` that reaches past it', () => {
  it('names the environment’s model over a blanked config — a model the loop will not use', async () => {
    // KNOWN DIVERGENCE, PINNED. This is #118's defect and #120's defect, on the knob #122 named
    // the rule for, and it is the exact confusion #69 was filed to end: the box states one model
    // and the process it is announcing runs another.
    //
    // The file assigns the knob and blanks it. `set -a` exports that blank OVER the inherited
    // `gpt-5-codex` (see the transcript in the header), so the loop hands codex NO `-m` flag and
    // codex picks its own default. `configured` asks a truthiness question, gets `''`, and falls
    // through to an environment value the loop has already thrown away.
    //
    // WHEN THIS IS FIXED — with the `configAssignsVar(...) ? parseConfigVar(...) : null` and `??`
    // that `RALPH_AGENT` and `GH_REPO` already use — the two expectations below become
    // `'codex — model resolves at first run'` and `undefined`, which is what a blanked knob and no
    // run behind it honestly add up to. Do not "repair" this test by loosening it.
    const { d } = await run({
      config: cfg(FOLDER, CODEX, `${MODEL}=""`),
      processEnv: { [MODEL]: 'gpt-5-codex' },
    })
    expect(rowOf(d, 'agent')).toBe('codex — gpt-5-codex (configured)')
    expect(rowOf(d, 'context')).toBe('400k tokens')

    // ...and the same run's actual command line, out of the module that builds it. The box names
    // a model; the loop passes none.
    expect(loopModelFlag('')).toBeNull()
  })

  it('reaches past every blank spelling bash masks with', async () => {
    // One row per spelling in the header's transcript. All five leave the loop with an empty
    // `RALPH_CODEX_MODEL`, and all five currently put the environment's value in the box — so the
    // divergence is a property of the PRECEDENCE RULE and not of one way of writing nothing.
    // `parseConfigVar` reads four of them as `''` and the unquoted-spaces line as `''` too (bash
    // ends the word at the `=`), which is why they all take the same path.
    for (const assignment of [
      `${MODEL}=""`,
      `${MODEL}=''`,
      `${MODEL}=`,
      `${MODEL}=   `,
      `export ${MODEL}=`,
    ]) {
      const { d } = await run({
        config: cfg(FOLDER, CODEX, assignment),
        processEnv: { [MODEL]: 'gpt-5-codex' },
      })
      expect(rowOf(d, 'agent'), assignment).toBe('codex — gpt-5-codex (configured)')
    }
  })

  it('names a window the very first event of the run will contradict', async () => {
    // The window knob, same shape, and here the contradiction is mechanical rather than
    // argumentative: `lib/capture-issue-event.js` reads `RALPH_CONTEXT_WINDOW` out of the
    // environment the loop was given, `Number('')` is 0, 0 is not a window, so the event records
    // the MAP's answer for the model. The box printed the environment's override instead.
    //
    // `resolveContextWindow` below is the very function the telemetry writer calls, handed the
    // value bash measured — so this is the first line that run will append to issues.jsonl,
    // asserted against the row that is on screen before it.
    const { d } = await run({
      config: cfg(FOLDER, CODEX, `${MODEL}=gpt-5-codex`, `${WINDOW}=""`),
      processEnv: { [WINDOW]: '200000' },
    })
    expect(rowOf(d, 'agent')).toBe('codex — gpt-5-codex (configured)')
    expect(rowOf(d, 'context')).toBe('200k tokens')
    // What the run will actually work with, and what its own log will say it worked with.
    expect(resolveContextWindow('gpt-5-codex', '')).toBe(400_000)
    // FIXED, this row reads `400k tokens` — the map's answer, because a blanked override is no
    // override — and the two numbers above stop disagreeing.
  })

  it('agrees with the loop when the blank is QUOTED WHITESPACE, which bash keeps', async () => {
    // The other side of the trade, and the reason the tests above are about PRESENCE rather than
    // about emptiness. `RALPH_CODEX_MODEL="   "` is a value in bash and a truthy value to
    // `parseConfigVar`, so the environment is masked in BOTH places, and the box lands on the
    // right answer for the right reason: three spaces are not a model id, `trimmedOr` in
    // lib/banner-model.js refuses them, and the row says the model is not known yet — which is
    // exactly what codex will do with no `-m` flag.
    const { d } = await run({
      config: cfg(FOLDER, CODEX, `${MODEL}="   "`),
      processEnv: { [MODEL]: 'gpt-5-codex' },
    })
    expect(rowOf(d, 'agent')).toBe('codex — model resolves at first run')
    expect(rowOf(d, 'context')).toBeUndefined()
    expect(loopModelFlag('   ')).toBeNull()

    // And the window knob, on the same spelling: `Number('   ')` is 0 in the box's resolver and in
    // the telemetry writer alike, so both fall to the map. One number, two readers, no drift.
    const { d: window } = await run({
      config: cfg(FOLDER, CODEX, `${MODEL}=gpt-5-codex`, `${WINDOW}="   "`),
      processEnv: { [WINDOW]: '200000' },
    })
    expect(rowOf(window, 'context')).toBe('400k tokens')
    expect(resolveContextWindow('gpt-5-codex', '   ')).toBe(400_000)
  })

  it('still answers config-over-environment when the config value is a real one', async () => {
    // The closure's actual contract, in one table, so nothing above can be satisfied by a change
    // that breaks the ordinary case. Both knobs, both directions: the file wins when it says
    // something, the environment answers when the file is silent.
    const { d: fromFile } = await run({
      config: cfg(FOLDER, CODEX, `${MODEL}=gpt-5-codex`, `${WINDOW}=200000`),
      processEnv: { [MODEL]: 'gpt-4o', [WINDOW]: '128000' },
    })
    expect(rowOf(fromFile, 'agent')).toBe('codex — gpt-5-codex (configured)')
    expect(rowOf(fromFile, 'context')).toBe('200k tokens')

    const { d: fromEnv } = await run({
      config: cfg(FOLDER, CODEX),
      processEnv: { [MODEL]: 'gpt-4o', [WINDOW]: '128000' },
    })
    expect(rowOf(fromEnv, 'agent')).toBe('codex — gpt-4o (configured)')
    expect(rowOf(fromEnv, 'context')).toBe('128k tokens')
  })
})

describe('QA #122 — an environment bag that does not have the key at all', () => {
  it('answers "nobody configured this" and leaks no `undefined` into a row', async () => {
    // `processEnv[name]` on an absent property is `undefined`, which is what the dot access it
    // replaced also produced — and the box's contract is that this reads as UNSET, not as a fact.
    // The `not.toContain('undefined')` is the assertion with teeth: a stringly-typed fact that
    // slipped through `trimmedOr` would surface as a visible row value, and this is the whole
    // output of the command, not just the box.
    const { d } = await run({ config: cfg(FOLDER, CODEX), processEnv: {} })
    expect(rowOf(d, 'agent')).toBe('codex — model resolves at first run')
    expect(rowOf(d, 'context')).toBeUndefined()
    expect(d.stdout.output()).not.toContain('undefined')
    expect(d.stderr.output()).not.toContain('undefined')
  })

  it('does the same for a bag with no prototype and for one holding only other keys', async () => {
    // Two shapes a caller could hand this command that a `{}` literal does not cover: a
    // prototype-less bag, where even `Object.prototype` cannot answer for a missing key, and a bag
    // full of unrelated ambient variables, where the closure must not be satisfied by a name that
    // merely resembles the knob.
    for (const [label, processEnv] of [
      ['Object.create(null)', Object.create(null)],
      ['unrelated keys only', { PATH: '/usr/bin', RALPH_CODEX_MODEL_X: 'no', MY_RALPH_CODEX_MODEL: 'no' }],
      ['frozen and empty', Object.freeze({})],
    ]) {
      const { d, result } = await run({ config: cfg(FOLDER, CODEX), processEnv })
      expect(result, label).toEqual({ exitCode: 0, started: true, count: 3 })
      expect(rowOf(d, 'agent'), label).toBe('codex — model resolves at first run')
      expect(rowOf(d, 'context'), label).toBeUndefined()
      expect(d.stdout.output(), label).not.toContain('undefined')
    }
  })

  it('leaves the claude row on the log when neither knob is in the environment', async () => {
    // The other half of "unset": on the log path an absent knob must change nothing at all. The
    // window here comes from the event, which already folded in whatever override THAT run had,
    // so an empty environment is not evidence about it.
    const { d } = await run({ config: cfg(FOLDER), metrics: HISTORY, processEnv: {} })
    expect(rowOf(d, 'agent')).toBe('claude — claude-opus-5 (last run)')
    expect(rowOf(d, 'context')).toBe('1M tokens')
  })
})

describe('QA #122 — a prototype-reachable key on the environment bag', () => {
  it('reads an inherited value, exactly as the dot access it replaced did', async () => {
    // `configured` indexes the bag with a computed name, so the question is fair to ask: does
    // `processEnv[name]` see something a shell could not have exported? It sees an INHERITED
    // property — and so does the expression #122 removed, which is what the two assertions
    // directly below are for. Property access does not care whether the name was written as a
    // literal or computed, so this is not a #122 regression and hardening it would belong on the
    // bag (or on every one of the five reads in this function), not on this closure.
    //
    // JUDGEMENT, since the row below names a value no shell supplied: TEST-HARNESS ARTIFACT, not
    // a live risk. `process.env` is a Node-managed exotic object whose prototype is
    // `Object.prototype`, so reaching this state in a real `ralph start` needs somebody to have
    // polluted `Object.prototype` with a SCREAMING_CASE key inside this process — at which point
    // the banner is not the interesting problem. It is pinned rather than fixed because pinning it
    // records that the closure inherited the property lookup it was refactored out of.
    const inherited = Object.create({ [MODEL]: 'injected-model', [WINDOW]: '200000' })
    expect(Object.keys(inherited)).toEqual([])
    expect(Object.hasOwn(inherited, MODEL)).toBe(false)
    // The pre-#122 spelling, on the same bag: identical answer. The bracket is not the reason.
    expect(inherited.RALPH_CODEX_MODEL).toBe('injected-model')

    const { d } = await run({ config: cfg(FOLDER, CODEX), processEnv: inherited })
    expect(rowOf(d, 'agent')).toBe('codex — injected-model (configured)')
    expect(rowOf(d, 'context')).toBe('200k tokens')
  })

  it('lets the config win over an inherited value, so the precedence is unchanged', async () => {
    // The inherited key is reached through the fallback arm and nothing else: a file that names
    // the knob still decides, which is the property that matters if the case above ever became
    // reachable for real.
    const inherited = Object.create({ [MODEL]: 'injected-model' })
    const { d } = await run({
      config: cfg(FOLDER, CODEX, `${MODEL}=gpt-5-codex`),
      processEnv: inherited,
    })
    expect(rowOf(d, 'agent')).toBe('codex — gpt-5-codex (configured)')
  })
})

describe('QA #122 — the knobs that do NOT call the closure still depart from it', () => {
  it('RALPH_BANNER stays ENVIRONMENT over config, in both directions', async () => {
    // The deliberate inversion (#74): a banner is a property of the invocation, so a wrapper
    // script or a CI job silences it without committing to a file every other run shares. Both
    // directions are asserted, because only the pair distinguishes an inversion from an accident —
    // a closure applied here would make the FILE win and the second case below would grow a box.
    const { d: envWins } = await run({
      config: cfg(FOLDER, 'RALPH_BANNER=off'),
      processEnv: { RALPH_BANNER: 'full' },
    })
    expect(boxOf(envWins).length).toBeGreaterThan(2)

    const { d: envSilences } = await run({
      config: cfg(FOLDER, 'RALPH_BANNER=full'),
      processEnv: { RALPH_BANNER: 'off' },
    })
    expect(boxOf(envSilences)).toEqual([])
    // ...and `off` is still a promise about bytes: no blank line where the box was.
    expect(envSilences.stdout.output().startsWith(LF)).toBe(false)
  })

  it('RALPH_AGENT stays PRESENT-OR-ABSENT: a blanked config masks the environment', async () => {
    // #118, pinned from outside: the blank the closure reaches past is honoured here. The loop
    // resolves claude from that empty value, so the box says claude and — the second half of that
    // issue — no warning is printed about a `codex` no run will read.
    const { d } = await run({
      config: cfg(FOLDER, 'RALPH_AGENT=""'),
      processEnv: { RALPH_AGENT: 'codex' },
      metrics: HISTORY,
    })
    expect(rowOf(d, 'agent')).toBe('claude — claude-opus-5 (last run)')
    expect(d.stderr.output()).not.toContain('RALPH_AGENT')

    // ...and the one case bash falls through on still falls through here.
    const { d: absent } = await run({
      config: cfg(FOLDER),
      processEnv: { RALPH_AGENT: 'codex', [MODEL]: 'gpt-5-codex' },
    })
    expect(rowOf(absent, 'agent')).toBe('codex — gpt-5-codex (configured)')
  })

  it('GH_REPO stays PRESENT-OR-ABSENT: the blank passes straight through to origin', async () => {
    // #120, pinned from outside. A blank assignment masks the environment in the sourcing shell,
    // the loop's `gh` reads an empty variable as unset and resolves its base repository from
    // origin — so handing the blank through is what puts origin's slug on the row. A `||` here
    // would print `ambient/repo`, a repository no `gh` call in the run is about to touch.
    const { d } = await run({
      config: cfg(GITHUB, 'GH_REPO=""'),
      processEnv: { GH_REPO: 'ambient/repo' },
    })
    expect(rowOf(d, 'repo')).toBe(ORIGIN_SLUG)

    // ...and an absent assignment still lets the environment answer, which is every project that
    // never heard of this knob.
    const { d: absent } = await run({
      config: cfg(GITHUB),
      processEnv: { GH_REPO: 'ambient/repo' },
    })
    expect(rowOf(absent, 'repo')).toBe('ambient/repo')
  })

  it('answers the SAME blanked file two opposite ways, in one box', async () => {
    // The sharpest statement of the defect this file exists for, and the reason it belongs in
    // `ralph start`'s own suite rather than in a resolver's. ONE committed config, TWO knobs
    // blanked in it, ONE environment supplying both — and the box:
    //
    //   repo    lucasfe/ralph                 the blank was honoured (#120's `??`)
    //   agent   codex — gpt-5-codex (…)       the blank was reached past (#122's `||`)
    //
    // Same file, same shell, same `set -a`, opposite readings. Whichever way the project settles
    // that question, both rows should be answering it the same way.
    const { d } = await run({
      config: cfg(GITHUB, CODEX, `${MODEL}=""`, 'GH_REPO=""'),
      processEnv: { [MODEL]: 'gpt-5-codex', GH_REPO: 'ambient/repo' },
    })
    expect(rowOf(d, 'repo')).toBe(ORIGIN_SLUG)
    expect(rowOf(d, 'agent')).toBe('codex — gpt-5-codex (configured)')
  })

  it('TASK_SOURCE keeps its own reader and the same config-over-environment answer', async () => {
    // Not a fourth departure and not a call site either: same precedence, different READER
    // (`parseConfigSource` knows the file's own spellings of this knob). What is pinned is that
    // moving the rule into a closure did not move this line's ANSWER, in all three of its cases —
    // the file deciding, the environment answering for a silent file, and an unrecognised value
    // resolving to the default rather than being echoed raw.
    const { d: fromFile } = await run({
      config: cfg(FOLDER),
      processEnv: { TASK_SOURCE: 'github' },
    })
    expect(rowOf(fromFile, 'source')).toBe('folder')

    const { d: fromEnv } = await run({ config: '', processEnv: { TASK_SOURCE: 'folder' } })
    expect(rowOf(fromEnv, 'source')).toBe('folder')

    const { d: nonsense } = await run({
      config: cfg('TASK_SOURCE=banana'),
      processEnv: { TASK_SOURCE: 'folder' },
    })
    expect(rowOf(nonsense, 'source')).toBe('github')
  })

  it('reaches past a blanked TASK_SOURCE too, on the same `||` — pinned, not endorsed', async () => {
    // THE COMPANION DIVERGENCE, and the reason "TASK_SOURCE is not a fourth" is a statement about
    // the READER rather than about the RULE: this line is `parseConfigSource(configText) ||
    // processEnv[TASK_SOURCE]`, so a blanked `TASK_SOURCE=` in the file behaves exactly like the
    // blanked model above. `set -a` exports the blank, the loop's own `resolveSource` reads it as
    // unset and runs in GITHUB mode, and this box says `folder` — which is not a cosmetic
    // disagreement: the source row is the run's intake, and the preflight below it spends the same
    // binding, so the command checks a folder queue for a loop that will read issues from GitHub.
    //
    // FIXED, alongside the two knobs above, this expectation becomes `'github'`.
    const { d } = await run({
      config: cfg('TASK_SOURCE=""'),
      processEnv: { TASK_SOURCE: 'folder' },
    })
    expect(rowOf(d, 'source')).toBe('folder')
  })
})
