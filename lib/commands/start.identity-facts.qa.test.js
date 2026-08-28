// #69 QA — adversarial specs for the WIRING of the five identity facts into `ralph start`.
//
// start.identity-facts.test.js proves the intended matrix: the precedence, the four model
// answers, the source table, the repo row in github mode, and the three reads that pay for
// all of it. This file attacks the same wiring from outside that matrix, along the four seams
// that are this command's rather than the box's or the resolver's:
//
//   * THE READS CAN FAIL IN SHAPES A HAPPY PATH NEVER PRODUCES. `<cwd>/.git` is a FILE in a
//     worktree and in a submodule, so the read of `<cwd>/.git/config` fails with ENOTDIR
//     rather than ENOENT — a distinct errno on a path this command constructs by hand. The
//     metrics log is appended to with `>>` by a loop that can be killed mid-line. Both are
//     read best-effort, and neither may cost the launch or the rows beside it.
//   * THE ENVIRONMENT IS AMBIENT. `GH_REPO`, `RALPH_AGENT` and `RALPH_CODEX_MODEL` are
//     inherited from whatever shell, wrapper script or CI runner invoked this, so each of
//     them can be blank, a control byte, or not a string at all. The row must degrade to
//     nothing rather than to something wrong, and it must never put a byte on stdout that
//     forges a line.
//   * `RALPH_BANNER=off` IS A PROMISE ABOUT BYTES. #74's whole point is that a wrapper script
//     or a cron entry can turn the decoration off completely, and #69 added five rows and two
//     file reads to the thing being turned off. Not one byte, and the reads that were hoisted
//     for #60's projection still happen exactly once.
//   * THE WHOLE PIPELINE IS THE UNIT. The resolver's spec asserts what a log line resolves
//     to and the box's spec asserts what a fact prints as. Only here can a fact travel from a
//     log line all the way to a terminal — which is where the fractional-window row below is
//     visible as a thing a user can actually see.
//
// The harness is start.identity-facts.test.js's, deliberately: every seam is injected (#41),
// so nothing here depends on the developer's checkout — not their .git, not their .ralph, not
// their environment. Control bytes are spelled with `String.fromCharCode` (#107).

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { startCommand } from './start.js'
import { metricsPath } from '../issue-metrics.js'
import { EMPTY_VERSION_CACHE } from '../version-cache.js'

const REPO = '/repo'
const HOME = '/home/me'
const VERSION = '1.2.3'
const METRICS_PATH = metricsPath(REPO)
const GIT_CONFIG_PATH = resolve(REPO, '.git', 'config')
const GITHUB = 'TASK_SOURCE=github\n'
const FOLDER = 'TASK_SOURCE=folder\n'
const MIN = 60000

const ESC = String.fromCharCode(27)
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const C1_CSI = String.fromCharCode(0x9b)
const PLACEHOLDER = String.fromCharCode(0xfffd)
const LABEL_WIDTH = 8

const eventLine = (fields) => `RALPH_ISSUE_EVENT ${JSON.stringify(fields)}`
const HISTORY =
  [
    {
      issue_number: 29,
      run_id: 'ralph-a',
      ts: 1,
      duration_ms: 97 * MIN,
      total_cost_usd: 34.1,
      agent: 'claude',
      model: 'claude-sonnet-4',
      context_window: 200_000,
    },
    {
      issue_number: 30,
      run_id: 'ralph-b',
      ts: 2,
      duration_ms: 71 * MIN,
      total_cost_usd: 28.75,
      agent: 'claude',
      model: 'claude-opus-5',
      context_window: 1_000_000,
    },
  ]
    .map(eventLine)
    .join(LF) + LF

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
    lines: () => chunks.join('').split(LF).slice(0, -1),
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

const deps = ({
  config = FOLDER,
  metrics = '',
  gitConfig = GIT_CONFIG,
  queue = 3,
  exec,
  ...overrides
} = {}) => {
  const stdout = makeStream()
  const stderr = makeStream()
  const paths = { exists: [], readFile: [] }
  const value = (fixture) => (typeof fixture === 'function' ? fixture() : fixture)
  return {
    cwd: REPO,
    stdout,
    stderr,
    paths,
    exec: exec ?? makeExec(),
    exists: (p) => {
      paths.exists.push(String(p))
      return String(p).endsWith('ralph.config.sh') && config != null
    },
    readFile: (p) => {
      const path = String(p)
      paths.readFile.push(path)
      if (path.endsWith('ralph.config.sh')) return value(config)
      if (path.endsWith('issues.jsonl')) return value(metrics)
      if (path === GIT_CONFIG_PATH) return value(gitConfig)
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

/**
 * A row's value in the BARE form, which has no frame to find it by.
 *
 * Matched on the eight-column gutter rather than on `includes`, so a label that happens to
 * appear inside another row's value cannot answer for it.
 */
const bareRowOf = (d, label) => {
  const row = d.stdout
    .lines()
    .map(stripAnsi)
    .find((line) => line.startsWith(label.padEnd(LABEL_WIDTH)))
  return row === undefined ? undefined : row.slice(LABEL_WIDTH).trimEnd()
}

/**
 * The banner's own lines, which is the block the width guarantee is about.
 *
 * By INDEX, because the banner is the first thing this command prints and because below 44
 * columns there is no frame to find it by — and deliberately NOT the whole stream: the
 * preflight notices under it (the WhatsApp hint, the queue count) are prose this box never
 * promised to clip.
 */
const bannerLinesOf = (d, height) => d.stdout.lines().slice(0, height)

const run = async (options) => {
  const d = deps(options)
  const result = await startCommand(d)
  return { d, result }
}

describe('QA #69 start — a window a user can see, out of a log a user can write', () => {
  it('draws no context row for a fractional window in the log', async () => {
    // END-TO-END REACHABILITY of the `0M tokens` row, which is the reason this test is here
    // rather than only in lib/banner-compose.model-rows.qa.test.js:
    //
    //   RALPH_CONTEXT_WINDOW=0.5 ralph start
    //
    // is accepted by lib/capture-issue-event.js — its guard is `Number.isFinite(cw) && cw > 0`
    // — so the run's event carries `"context_window":0.5`. lib/banner-model.js's
    // `positiveNumberOr` accepts it on the same terms and reports it as this run's window, and
    // the box floors it to 0, divides it exactly by a million and prints `context  0M tokens`:
    // a window no model has and nobody configured. A row the box worked out for itself is
    // exactly what the flooring comment above `windowTokens` says must never happen, and the
    // dev's own table pins `0` and `-1` as NO ROW — so this is that table's own rule, applied
    // to the one value that slips past the guard.
    for (const contextWindow of [0.5, 0.999, 1e-7]) {
      const metrics = eventLine({ ts: 3, agent: 'claude', model: 'claude-opus-5', context_window: contextWindow })
      const { d } = await run({ config: GITHUB, metrics: `${metrics}${LF}` })
      // The model is real evidence and its row stays; only the window is unknowable.
      expect(rowOf(d, 'agent'), String(contextWindow)).toBe('claude — claude-opus-5 (last run)')
      expect(rowOf(d, 'context'), String(contextWindow)).toBeUndefined()
      expect(d.stdout.output(), String(contextWindow)).not.toContain('0M tokens')
    }
  })

  it('reports a whole-number window from the log unchanged', async () => {
    // The other direction, so the test above cannot be satisfied by dropping the row
    // whenever an override was used: an odd but honest RALPH_CONTEXT_WINDOW prints as itself.
    for (const [contextWindow, expected] of [
      [1_000_000, '1M tokens'],
      [123_456, '123456 tokens'],
      [1, '1 tokens'],
      [7_500, '7500 tokens'],
    ]) {
      const metrics = eventLine({ ts: 3, agent: 'claude', model: 'm', context_window: contextWindow })
      const { d } = await run({ config: GITHUB, metrics: `${metrics}${LF}` })
      expect(rowOf(d, 'context'), String(contextWindow)).toBe(expected)
    }
  })

  it('starts, and claims nothing, on a log whose ONLY line was truncated', async () => {
    // The state a file appended to with `>>` is left in when the very first run of a repo was
    // killed mid-line: no older event to fall back to, and nothing salvageable from the
    // fragment. Asserted here rather than only in the resolver's spec because the SAME text is
    // read once and serves two consumers — the box, which must claim nothing, and #60's launch
    // projection at the bottom of the run, which must still print.
    const truncated = 'RALPH_ISSUE_EVENT {"agent":"claude","model":"claude-op'
    const { d, result } = await run({ config: GITHUB, metrics: truncated })
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
    expect(rowOf(d, 'agent')).toBe('claude — model resolves at first run')
    expect(rowOf(d, 'context')).toBeUndefined()
    // ...and the ONE read that served both consumers still happened once. #60's projection
    // draws nothing here for the same reason the box does — there is no complete event in this
    // file to measure — which is the coupling this test is really about: one unusable log, two
    // features declining to guess.
    expect(d.paths.readFile.filter((p) => p.endsWith('issues.jsonl'))).toEqual([METRICS_PATH])
    expect(d.stdout.output()).not.toContain('Projection:')
  })

  it('reports the newest PARSEABLE event when the tail was truncated behind it', async () => {
    // The same file with history above the fragment, pinned as the deliberate reading it is:
    // an unparseable line is SKIPPED, so the row names the newest event that is actually an
    // event. Worth stating plainly, because there is a nuance a reader could mistake for a
    // defect — the truncated line belongs to a run this row is then not describing, so
    // `last run` means "the last run we have a complete record of". That is the same
    // discipline aggregateCycleCounts in lib/issue-metrics.js applies to the same lines, and
    // the alternative (no row at all whenever a log ends mid-write) would cost the row on
    // most real checkouts.
    const truncated = 'RALPH_ISSUE_EVENT {"agent":"claude","model":"claude-op'
    const { d } = await run({ config: GITHUB, metrics: `${HISTORY}${truncated}` })
    expect(rowOf(d, 'agent')).toBe('claude — claude-opus-5 (last run)')
    expect(rowOf(d, 'context')).toBe('1M tokens')
    // ...and the other consumer of the same text got its two complete events too.
    expect(d.stdout.output()).toContain('Projection:')
  })

  it('sanitises a model id carrying control bytes, and forges no line with it', async () => {
    // The metrics log is a file this command does not write and does not read as bytes: a
    // foreign writer, a mangled pipe or a hand edit can put anything inside a JSON string.
    // The resolver hands it on untouched by design (that is the box's gate to apply), so this
    // is the assertion that the two halves actually meet on the way to a terminal.
    for (const byte of [ESC, LF, CR, C1_CSI, String.fromCharCode(0)]) {
      const metrics = eventLine({ ts: 3, agent: 'claude', model: `opus${byte}5` })
      const { d } = await run({ config: GITHUB, metrics: `${metrics}${LF}` })
      const label = byte.charCodeAt(0).toString()
      expect(rowOf(d, 'agent'), label).toBe(
        `claude — opus${PLACEHOLDER}5 (last run)`,
      )
      // Every row is inside the frame, and the box is still six sides of one box.
      const box = boxOf(d)
      expect(box.length, label).toBeGreaterThan(2)
      for (const line of box.slice(1, -1)) expect(line, label).toMatch(/^│ .* │$/)
      expect(box.filter((line) => line.startsWith('╭')), label).toHaveLength(1)
      // ...and no escape byte from the LOG reached the stream. The banner's own colour is off
      // here (no TTY), so any ESC on stdout came from the fact.
      expect(d.stdout.output(), label).not.toContain(ESC)
      expect(d.stdout.output(), label).not.toContain(C1_CSI)
    }
  })

  it('names no model for a log whose newest event belongs to another agent’s run', async () => {
    // The dev's spec covers a Codex event; these are the shapes a log picks up from a repo
    // that has been through several agents and several Ralph versions.
    for (const agent of ['codex', 'gemini', 'CLAUDE', 'claude-code']) {
      const metrics = `${HISTORY}${eventLine({ ts: 3, agent, model: 'not-ours' })}${LF}`
      const { d } = await run({ config: GITHUB, metrics })
      expect(rowOf(d, 'agent'), agent).toBe('claude — model resolves at first run')
      expect(d.stdout.output(), agent).not.toContain('not-ours')
    }
  })
})

describe('QA #69 start — the repo row degrades rather than guesses', () => {
  it('draws no repo row when .git is a FILE, as it is in a worktree', async () => {
    // A worktree and a submodule both have `<cwd>/.git` as a FILE holding `gitdir: …`, so the
    // read of `<cwd>/.git/config` fails with ENOTDIR — a different errno from the ENOENT of a
    // directory that is simply not a repository, on a path this command builds by hand. Both
    // must cost one row and nothing else.
    const enotdir = () => {
      const error = new Error("ENOTDIR: not a directory, open '/repo/.git/config'")
      error.code = 'ENOTDIR'
      throw error
    }
    for (const gitConfig of [enotdir, () => 'gitdir: /repo/.git/worktrees/feature\n', () => undefined]) {
      const { d, result } = await run({ config: GITHUB, gitConfig, metrics: HISTORY })
      expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
      expect(rowOf(d, 'repo')).toBeUndefined()
      // One unresolvable fact costs one row: the rows around it are all still there.
      expect(rowOf(d, 'source')).toBe('github')
      expect(rowOf(d, 'cwd')).toBe(REPO)
      expect(rowOf(d, 'agent')).toBe('claude — claude-opus-5 (last run)')
    }
  })

  // GH_REPO as an environment can actually hand it over, and the row each value earns.
  const GH_REPOS = [
    ['gh’s host-prefixed spelling', 'github.com/someone/else', 'someone/else'],
    ['an enterprise host prefix', 'ghe.internal.example/someone/else', 'someone/else'],
    ['a .git suffix', 'someone/else.git', 'someone/else'],
    ['surrounding whitespace', '  someone/else  ', 'someone/else'],
    ['a trailing newline a script forgot to chomp', `someone/else${LF}`, 'someone/else'],
    // ...and everything that is not a slug gh could read an issue from. NOT the origin slug:
    // GH_REPO is what gh itself reads, so naming origin would name a repository the loop is
    // not about to use — which is the exact confusion this row was asked to end.
    ['four segments', 'a/b/c/d', undefined],
    ['one segment', 'ralph', undefined],
    ['a whole url', 'https://github.com/someone/else', undefined],
    ['an ssh url', 'git@github.com:someone/else.git', undefined],
    ['a relative path', '../else', undefined],
    ['a query string', 'someone/else?ref=main', undefined],
    ['an ESC sequence', `someone/else${ESC}[31m`, undefined],
    ['an embedded newline', `someone${LF}/else`, undefined],
    ['a forged row', `o/n${LF}│ repo    evil/repo`, undefined],
  ]

  for (const [label, ghRepo, expected] of GH_REPOS) {
    it(`draws ${JSON.stringify(expected)} for a GH_REPO with ${label}`, async () => {
      const { d, result } = await run({
        config: GITHUB,
        processEnv: { GH_REPO: ghRepo },
        metrics: HISTORY,
      })
      expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
      expect(rowOf(d, 'repo')).toBe(expected)
      // Whatever the value was, it did not become a line: exactly one box, every row inside
      // the frame, and no `evil/repo` row smuggled in under a real one.
      const box = boxOf(d)
      expect(box.filter((line) => line.startsWith('╰'))).toHaveLength(1)
      for (const line of box.slice(1, -1)) expect(line).toMatch(/^│ .* │$/)
      expect(box.filter((line) => stripAnsi(line).startsWith('│ repo')).length).toBeLessThanOrEqual(
        1,
      )
      expect(d.stdout.output()).not.toContain('evil/repo')
    })
  }

  it('reads .git/config for nothing in folder mode, even with GH_REPO set', async () => {
    // Folder mode reads no issues from a repository, so there is no repo row to draw and no
    // reason to touch the file — and a GH_REPO left over in the environment from another
    // checkout must not conjure one.
    const { d } = await run({
      config: FOLDER,
      processEnv: { GH_REPO: 'someone/else' },
      metrics: HISTORY,
    })
    expect(rowOf(d, 'repo')).toBeUndefined()
    expect(rowOf(d, 'source')).toBe('folder')
    expect(d.paths.readFile).not.toContain(GIT_CONFIG_PATH)
    expect(d.stdout.output()).not.toContain('someone/else')
  })

  it('keeps the row when the repo is resolvable but the metrics log is unreadable', async () => {
    // The two new reads are independent: a log that throws must not cost the repo row, and a
    // .git/config that throws must not cost the model row. Asserted both ways round, because
    // one try/catch around both reads would pass every test that varies only one of them.
    const throws = () => {
      throw new Error('EACCES')
    }
    const { d: noLog } = await run({ config: GITHUB, metrics: throws })
    expect(rowOf(noLog, 'repo')).toBe('lucasfe/ralph')
    expect(rowOf(noLog, 'agent')).toBe('claude — model resolves at first run')

    const { d: noGit } = await run({ config: GITHUB, gitConfig: throws, metrics: HISTORY })
    expect(rowOf(noGit, 'repo')).toBeUndefined()
    expect(rowOf(noGit, 'agent')).toBe('claude — claude-opus-5 (last run)')
  })

  it('keeps the launch when reading GH_REPO out of the environment is what throws', async () => {
    // THE ONE INPUT THE RESOLVER CANNOT DEFEND ITSELF AGAINST, exercised where the defence
    // actually lives. `resolveBannerRepo` type-checks every VALUE it is handed rather than
    // coercing it (lib/git-remote-slug.js's header says why, and #116 moved that grammar into
    // a module of its own), but the bag's fields are read by plain destructuring — so a
    // `GH_REPO` that is an ACCESSOR rather than a string runs somebody else's code before the
    // resolver sees anything, and the throw is not the resolver's to catch. What makes that
    // safe is this command: `bannerRepoSlug` builds the bag inside its own `try`, so the
    // failure costs the row and the row alone.
    //
    // Not hypothetical for a library consumer — `processEnv` is an injected seam, and a proxy
    // or a lazily-resolved config object is a perfectly ordinary thing to inject through it.
    // The assertion that matters is the last one: the loop still starts.
    let reads = 0
    const { d, result } = await run({
      config: GITHUB,
      metrics: HISTORY,
      processEnv: {
        get GH_REPO() {
          reads += 1
          throw new Error('the accessor ran')
        },
      },
    })
    // Counted, so the test cannot pass because nothing read the variable at all: a missing row
    // is what a missing READ looks like too, and only one of the two is what is being asserted.
    expect(reads).toBeGreaterThan(0)
    expect(rowOf(d, 'repo')).toBeUndefined()
    // Every other row of the box is untouched, including the one resolved from the OTHER file
    // read for it — the two reads are independent, as the test above this one asserts from the
    // other direction.
    expect(rowOf(d, 'agent')).toBe('claude — claude-opus-5 (last run)')
    expect(rowOf(d, 'source')).toBe('github')
    expect(rowOf(d, 'cwd')).toBe(REPO)
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
  })
})

describe('QA #69 start — the environment is ambient, the config is the loop’s', () => {
  it('takes RALPH_CODEX_MODEL from the environment when only the agent is configured', async () => {
    // The mixed case the precedence rule does not obviously cover: the file names the agent
    // and says nothing about the model, so the model comes from the environment the loop will
    // inherit — the same value templates/ralph.sh would pass on the command line.
    const { d } = await run({
      config: `${FOLDER}RALPH_AGENT=codex\n`,
      processEnv: { RALPH_CODEX_MODEL: 'gpt-5-codex' },
      metrics: HISTORY,
    })
    expect(rowOf(d, 'agent')).toBe('codex — gpt-5-codex (configured)')
    expect(rowOf(d, 'context')).toBe('400k tokens')
  })

  it('trims a configured model, and refuses one that is only whitespace', async () => {
    // RALPH_CODEX_MODEL is a value people edit by hand in a shell file, where a trailing
    // space is invisible — and where a quoted empty value is a real thing to leave behind.
    for (const [assigned, expected] of [
      ['gpt-5-codex ', 'codex — gpt-5-codex (configured)'],
      [' gpt-5-codex', 'codex — gpt-5-codex (configured)'],
      ['""', 'codex — model resolves at first run'],
      ["''", 'codex — model resolves at first run'],
    ]) {
      const { d } = await run({
        config: `${FOLDER}RALPH_AGENT=codex\nRALPH_CODEX_MODEL=${assigned}\n`,
        metrics: HISTORY,
      })
      expect(rowOf(d, 'agent'), JSON.stringify(assigned)).toBe(expected)
    }
  })

  it('sanitises a hostile RALPH_CODEX_MODEL rather than obeying it', async () => {
    // The Codex model is the one model id that reaches the box from an environment variable
    // instead of from a log, so it is the one a wrapper script can set to anything.
    const { d } = await run({
      config: `${FOLDER}RALPH_AGENT=codex\n`,
      processEnv: { RALPH_CODEX_MODEL: `gpt${ESC}[31m5` },
      metrics: HISTORY,
    })
    expect(rowOf(d, 'agent')).toContain(PLACEHOLDER)
    expect(d.stdout.output()).not.toContain(ESC)
    for (const line of boxOf(d).slice(1, -1)) expect(line).toMatch(/^│ .* │$/)
  })

  it('names the agent that will RUN, for every spelling of RALPH_AGENT', async () => {
    // `resolveAgent` trims, lowercases, and warns-and-falls-back rather than aborting an
    // unattended run — so the row reports what is ABOUT TO RUN rather than what was typed, in
    // both directions:
    //
    //   a typo, a control byte, a blank    →  claude, and the log's model is its evidence
    //   a case or padding variant of codex →  codex, whose model comes from a knob that is
    //                                         not set here, so it promises nothing
    //
    // The second half is what makes this more than a fallback test: a row that reported the
    // RAW value would name `CODEX` and then read the log for a Claude model, which is the
    // over-confident row the provenance tag exists to prevent.
    for (const [RALPH_AGENT, expected] of [
      ['codx', 'claude — claude-opus-5 (last run)'],
      ['claude-code', 'claude — claude-opus-5 (last run)'],
      ['gemini', 'claude — claude-opus-5 (last run)'],
      [`codex${ESC}[31m`, 'claude — claude-opus-5 (last run)'],
      ['', 'claude — claude-opus-5 (last run)'],
      ['   ', 'claude — claude-opus-5 (last run)'],
      [`claude${LF}`, 'claude — claude-opus-5 (last run)'],
      ['CODEX', 'codex — model resolves at first run'],
      [' codex ', 'codex — model resolves at first run'],
      ['Codex', 'codex — model resolves at first run'],
    ]) {
      const { d } = await run({ config: GITHUB, processEnv: { RALPH_AGENT }, metrics: HISTORY })
      const label = JSON.stringify(RALPH_AGENT)
      expect(rowOf(d, 'agent'), label).toBe(expected)
      // ...and whichever way it resolved, no byte of the raw value reached the stream.
      expect(d.stdout.output(), label).not.toContain(ESC)
    }
  })
})

describe('QA #69 start — the rows the frame does not fit, and the ones nobody asked for', () => {
  it('prints not one byte of any of it when RALPH_BANNER is off', async () => {
    // #74's promise, re-asserted for #69's five rows and its two new reads: a wrapper script
    // or a cron entry that turned the decoration off must not get a model id, a repo slug or
    // a frame glyph — from a log full of history, a real origin remote, and a GH_REPO set.
    const { d, result } = await run({
      config: GITHUB,
      processEnv: { RALPH_BANNER: 'off', GH_REPO: 'someone/else' },
      metrics: HISTORY,
    })
    expect(result).toEqual({ exitCode: 0, started: true, count: 9 })
    const output = d.stdout.output()
    for (const forbidden of [
      '╭',
      '│',
      '╰',
      'claude-opus-5',
      'last run',
      '1M tokens',
      'someone/else',
      'lucasfe/ralph',
      'model resolves at first run',
    ]) {
      expect(output, forbidden).not.toContain(forbidden)
    }
  })

  it('still reads the metrics log exactly once with the banner off', async () => {
    // The read is HOISTED above the banner and shared with #60's launch projection, so
    // turning the banner off does not turn the read off — and it must not turn it into two
    // either. The projection at the bottom of the run is the proof the text still arrived.
    const { d } = await run({
      config: GITHUB,
      processEnv: { RALPH_BANNER: 'off' },
      metrics: HISTORY,
    })
    expect(d.paths.readFile.filter((p) => p.endsWith('issues.jsonl'))).toEqual([METRICS_PATH])
    expect(d.stdout.output()).toContain('Projection:')
  })

  it('carries all five rows into the bare form on a narrow terminal', async () => {
    // Below 44 columns there is no frame, and #69's rows are the ones most likely to be
    // treated as decoration a narrow terminal can do without. They are not: "which agent,
    // which model, which repo" is exactly what a reader on a 26-column pane is checking.
    for (const columns of [43, 30, 26]) {
      const { d } = await run({ config: GITHUB, columns, metrics: HISTORY })
      expect(boxOf(d), String(columns)).toEqual([])
      for (const label of ['agent', 'context', 'cwd', 'source', 'repo']) {
        expect(bareRowOf(d, label), `${label} @ ${columns}`).toBeDefined()
      }
      // Clipped to the columns the caller reported, never wrapped — one fact, one line. The
      // banner is the FIRST thing this command prints, so it is the first six lines: a title
      // and #69's five rows (this fixture has no update, no cache verdict and no changelog).
      for (const line of bannerLinesOf(d, 1 + 5)) {
        expect([...stripAnsi(line)].length, `${columns}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(
          columns,
        )
      }
    }
  })

  it('holds a narrow terminal even when every new fact is hostile', async () => {
    // The clip and the control-byte gate are the two mechanisms that decide what a line is,
    // and this is the one place they both run on a value that came out of a file: a model id
    // with an ESC in it, on a terminal too narrow for the row it belongs to.
    const metrics = eventLine({ ts: 3, agent: 'claude', model: `opus${ESC}[31m-5-very-long-id` })
    for (const columns of [43, 26, 12, 1]) {
      const { d, result } = await run({
        config: GITHUB,
        columns,
        metrics: `${metrics}${LF}`,
        processEnv: { GH_REPO: `o/n${LF}` },
      })
      expect(result, String(columns)).toEqual({ exitCode: 0, started: true, count: 9 })
      expect(d.stdout.output(), String(columns)).not.toContain(ESC)
      // A title and four rows this time: the event carries a model but no window, so there is
      // no `context` row to draw.
      for (const line of bannerLinesOf(d, 1 + 4)) {
        expect([...stripAnsi(line)].length, `${columns}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(
          columns,
        )
      }
    }
  })

  it('adds no field to the event it reads — criterion 9, through the writer’s own vocabulary', async () => {
    // #69 READS the metrics log and writes nothing to it, so none of its five facts may have
    // become an event field on the way past. Asserted against the LOG the command was handed:
    // a run that read this text and then appended to it would show up as a write, and a
    // feature that had quietly grown a field would show up in the vocabulary below.
    const { d } = await run({ config: GITHUB, metrics: HISTORY })
    const written = d.paths.readFile.filter((p) => p.endsWith('issues.jsonl'))
    expect(written).toEqual([METRICS_PATH])
    for (const word of ['provenance', 'last-run', 'configured', 'banner', 'repo', 'source']) {
      expect(HISTORY, word).not.toContain(word)
    }
  })
})
