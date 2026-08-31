// QA #122/#149 — the `sourcedValue` closure in `ralph start`, attacked at the one seam it created.
//
// #122's first part replaced two copies of `parseConfigVar(configText, NAME) || processEnv[NAME]`
// with one closure declared inside the #69 precedence note, and pointed the model and the window
// at it. Nothing about that was a behaviour change on the happy path — which is exactly why it was
// worth a file of its own. What the closure DID do is give the loop's precedence a NAME, in a
// comment block that told a reader "three knobs depart from this rule and each one's note says
// why". A named rule invited the question nobody had to ask while the expression was spelled out
// twice: is the rule the closure states the rule the loop actually follows?
//
// It was not, in one case, and that case is the whole of the first describe block below. #149 is
// the fix, and this file is where the fix is measured from the OUTSIDE: the three sites that used
// to be pinned as defects — the model, the window, and `TASK_SOURCE` in the last block — now
// assert the RIGHT answer, and each of them still carries the transcript that says why that
// answer is the right one.
//
// THE MEASUREMENT THIS FILE IS BUILT ON. templates/ralph.sh sources ralph.config.sh with `set -a`,
// so what the loop's environment holds for a knob is decided by whether the FILE ASSIGNED it, not
// by whether the file's value was truthy. Run against a real bash — GNU bash 5.3.15(1)-release,
// aarch64-apple-darwin25.4.0 — with an inherited value in place:
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
// Five of those six BLANK the inherited value, and `||` reached past every one of them. That was
// the same defect #118 fixed for `RALPH_AGENT` and #120 fixed for `GH_REPO`, and #149 applied the
// same `configAssignsVar` presence test — as one ternary, not their `?? processEnv` pair — to the
// two knobs #122 gathered into a closure and to the `TASK_SOURCE` line beside them, so the closure
// is now ONE rule that every knob in the box
// either calls or visibly departs from. The sixth spelling is asserted too, in its own test: it is
// the one where bash keeps a value, so it is the one where masking the environment was already
// right, and the fix must not have changed it.
//
// A SEVENTH SPELLING ONLY LOOKS LIKE ONE OF THE SIX, and it is not exercised here: it belongs to
// the READER rather than to this closure, so it is measured next door, in
// lib/parse-config-var.boundary.qa.test.js and in start.sourced-value.qa.test.js's fifth block.
// `RALPH_CODEX_MODEL= ""`, with a space after the `=`, is bash's environment-prefix syntax — bash
// assigns nothing and the inherited value stands. The #149 review found `parseConfigVar` calling
// that line present-and-blank, which masked exactly the value bash keeps; the grammar now refuses
// it. The transcript above is unaffected — none of its six rows has a space after the `=`.
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
//   * THE ONE DEPARTING KNOB STILL DEPARTS, and the three that used to be departures now agree.
//     `RALPH_BANNER` is inverted (environment over config) and that is deliberate; `RALPH_AGENT`,
//     `GH_REPO` and `TASK_SOURCE` all answer the same presence question as the model and the
//     window now, `TASK_SOURCE` through a reader of its own. They are cheap regression pins that
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
import { resolveSource } from '../task-source.js'
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

describe('QA #149 — a config value that is PRESENT BUT EMPTY, and the environment it masks', () => {
  it('names no model at all for a blanked config, because the loop will pass none', async () => {
    // #118's defect and #120's defect, on the knob #122 named the rule for, FIXED HERE: the box
    // no longer states one model while the process it is announcing runs another, which is the
    // exact confusion #69 was filed to end.
    //
    // The file assigns the knob and blanks it. `set -a` exports that blank OVER the inherited
    // `gpt-5-codex` (see the transcript in the header), so the loop hands codex NO `-m` flag and
    // codex picks its own default. `sourcedValue` asks the PRESENCE question — the file assigned
    // this name, so the file decides, blank included — and the environment never gets a word.
    // `resolveBannerModel` then has no model to name, so the row promises nothing and there is no
    // window to draw either.
    const { d } = await run({
      config: cfg(FOLDER, CODEX, `${MODEL}=""`),
      processEnv: { [MODEL]: 'gpt-5-codex' },
    })
    expect(rowOf(d, 'agent')).toBe('codex — model resolves at first run')
    expect(rowOf(d, 'context')).toBeUndefined()

    // ...and the same run's actual command line, out of the module that builds it. The box names
    // no model; the loop passes none. One claim, two readers, no drift.
    expect(loopModelFlag('')).toBeNull()
  })

  it('masks the environment for every blank spelling bash masks with', async () => {
    // One row per spelling in the header's transcript. All five leave the loop with an empty
    // `RALPH_CODEX_MODEL`, and all five now keep the environment's value out of the box — so the
    // rule is a property of the PRECEDENCE and not of one way of writing nothing.
    // `configAssignsVar` says PRESENT for all five (the name ends at the `=` in every one of them,
    // `export` prefix included), and `parseConfigVar` reads all five as `''`, including the
    // unquoted-spaces line — which is the same word bash ends at the `=`.
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
      expect(rowOf(d, 'agent'), assignment).toBe('codex — model resolves at first run')
      expect(rowOf(d, 'context'), assignment).toBeUndefined()
    }
  })

  it('names the window the very first event of the run will record', async () => {
    // The window knob, same shape, and here the agreement is mechanical rather than
    // argumentative: `lib/capture-issue-event.js` reads `RALPH_CONTEXT_WINDOW` out of the
    // environment the loop was given, `Number('')` is 0, 0 is not a window, so the event records
    // the MAP's answer for the model. The box now reports that same number instead of the
    // environment's override.
    //
    // `resolveContextWindow` below is the very function the telemetry writer calls, handed the
    // value bash measured — so this is the first line that run will append to issues.jsonl,
    // asserted against the row that is on screen before it.
    const { d } = await run({
      config: cfg(FOLDER, CODEX, `${MODEL}=gpt-5-codex`, `${WINDOW}=""`),
      processEnv: { [WINDOW]: '200000' },
    })
    expect(rowOf(d, 'agent')).toBe('codex — gpt-5-codex (configured)')
    expect(rowOf(d, 'context')).toBe('400k tokens')
    // What the run will actually work with, and what its own log will say it worked with — the
    // same number as the row above, which is the whole point of this test.
    expect(resolveContextWindow('gpt-5-codex', '')).toBe(400_000)
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

describe('QA #149 — one rule at every knob, and the one knob that still departs from it', () => {
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

  it('RALPH_AGENT is PRESENT-OR-ABSENT: a blanked config masks the environment', async () => {
    // #118, pinned from outside, and since #149 it is the closure's own rule rather than a
    // departure from it — this test is unchanged because the ANSWER is unchanged. The loop
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

  it('GH_REPO is PRESENT-OR-ABSENT: the blank passes straight through to origin', async () => {
    // #120, pinned from outside, and the closure's rule since #149 for the same reason as
    // `RALPH_AGENT` above. A blank assignment masks the environment in the sourcing shell,
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

  it('answers the SAME blanked file the SAME way twice, in one box', async () => {
    // The test this file exists for, and the reason it belongs in `ralph start`'s own suite rather
    // than in a resolver's. ONE committed config, TWO knobs blanked in it, ONE environment
    // supplying both — and before #149 the box read them oppositely:
    //
    //   repo    lucasfe/ralph                 the blank was honoured (#120's `??`)
    //   agent   codex — gpt-5-codex (…)       the blank was reached past (#122's `||`)
    //
    // Same file, same shell, same `set -a`, opposite readings. Both rows answer it the same way
    // now: the file assigned both names, so the file decides both, and neither row names something
    // the loop is not about to use.
    const { d } = await run({
      config: cfg(GITHUB, CODEX, `${MODEL}=""`, 'GH_REPO=""'),
      processEnv: { [MODEL]: 'gpt-5-codex', GH_REPO: 'ambient/repo' },
    })
    expect(rowOf(d, 'repo')).toBe(ORIGIN_SLUG)
    expect(rowOf(d, 'agent')).toBe('codex — model resolves at first run')
  })

  it('TASK_SOURCE reads the shared grammar and keeps the same config-over-environment answer', async () => {
    // An ordinary call site of the closure since #149, with no reader of its own: the review dropped
    // the per-site argument once it established that `parseConfigSource` is
    // `parseConfigVar(text, 'TASK_SOURCE')` verbatim. What is pinned is that neither moving the rule
    // into a closure (#122), nor moving this line onto it, nor dropping that argument moved this
    // line's ANSWER, in all three of its non-blank cases — the file deciding, the environment
    // answering for a silent file, and an unrecognised value resolving to the default rather than
    // being echoed raw.
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

  it('masks the environment for a blanked TASK_SOURCE, and the PREFLIGHT follows the row', async () => {
    // THE COMPANION SITE, and the reason "TASK_SOURCE is not a fourth" is no longer a statement about
    // the READER at all: the line is `sourcedValue('TASK_SOURCE')`, the same call as every other
    // knob's, so a blanked `TASK_SOURCE=""` in the file behaves exactly
    // like the blanked model above. `set -a` exports the blank, the loop's own dispatch expands
    // `${TASK_SOURCE:-github}` out of it and runs in GITHUB mode — measured against a real bash,
    // with `folder` inherited:
    //
    //   $ printf 'TASK_SOURCE=""\n' > c.sh
    //   $ TASK_SOURCE=folder bash -c 'set -a; . ./c.sh; set +a; printf "[%s]" "${TASK_SOURCE:-github}"'
    //   [github]
    //
    // — and this was the one blank that was never cosmetic. The `source` row is the run's intake,
    // and the preflight SPENDS THE SAME BINDING, so the command used to check a folder queue and
    // skip `gh auth status` for a loop that was about to read issues from GitHub. Both halves are
    // asserted here off one run: the row, and the three github-path calls under it.
    const folderCounts = []
    const { d, result } = await run({
      config: cfg('TASK_SOURCE=""'),
      processEnv: { TASK_SOURCE: 'folder' },
      folderQueueCount: async () => {
        folderCounts.push(1)
        return 3
      },
    })
    expect(rowOf(d, 'source')).toBe('github')
    // The gh-auth check the folder path skips, and the labels only the github path creates.
    expect(d.exec.calls.some((c) => c.key === 'gh auth status')).toBe(true)
    expect(d.exec.calls.some((c) => c.key.startsWith('gh label create'))).toBe(true)
    // The queue is GitHub's — `makeExec` answers 9 to the issue search — and the folder tree is
    // never counted at all.
    expect(d.exec.calls.some((c) => c.cmd === 'gh' && c.args.includes('--search'))).toBe(true)
    expect(folderCounts).toEqual([])
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
  })

  it('keeps quoted whitespace on TASK_SOURCE reading exactly as it did, in both readers', async () => {
    // The sixth spelling, on the knob where a wrong answer costs a queue. `TASK_SOURCE="   "` is a
    // value bash KEEPS, so the file masks the environment in the sourcing shell too — and both
    // readers then land on github, from opposite directions: `resolveSource` trims and reads blank
    // as the default, while the loop's own dispatch compares the untrimmed string against `folder`
    // and `jira` and falls to its `else`. Measured, with `folder` inherited:
    //
    //   $ printf 'TASK_SOURCE="   "\n' > c.sh
    //   $ TASK_SOURCE=folder bash -c 'set -a; . ./c.sh; set +a; printf "[%s]" "${TASK_SOURCE:-github}"'
    //   [   ]
    //
    // — three spaces, which is neither `folder` nor `jira` at templates/ralph.sh's dispatch block.
    // #149 must not have swept this case up: it is the one spelling where the presence test and a
    // truthiness test agree, and it read as github before the fix and reads as github after it.
    const { d } = await run({
      config: cfg('TASK_SOURCE="   "'),
      processEnv: { TASK_SOURCE: 'folder' },
    })
    expect(rowOf(d, 'source')).toBe('github')
    expect(resolveSource({ TASK_SOURCE: '   ' })).toBe('github')
  })
})
